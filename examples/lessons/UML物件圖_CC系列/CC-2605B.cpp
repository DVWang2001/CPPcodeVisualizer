// UML 物件圖教案 CC-2605B：分數向量（Fraction 私有欄位，建構時約分）
// （改寫自 CF 題目 CC-2605B：運算子多載、friend、繼承與 static 改成一般成員函式，才能在瀏覽器引擎逐步執行）
#include<iostream>
#include<vector>
using namespace std;
int gcd(int a,int b){
   if(a<0)a=-a;
   if(b<0)b=-b;
   return b==0?a:gcd(b,a%b);
}
class Fraction{
   int x,y;
public:
   Fraction(int a=0,int b=1):x(a),y(b){reduce();}
   void reduce(){
      int g=gcd(x,y);
      if(g!=0){ x/=g; y/=g; }
   }
   Fraction add(Fraction b)const{
      return Fraction(x*b.y+y*b.x,y*b.y);
   }
   Fraction mul(Fraction b)const{
      return Fraction(x*b.x,y*b.y);
   }
   Fraction div(int b)const{
      return Fraction(x,y*b);
   }
   void read(){
      char c;
      int p,q;
      cin>>p>>c>>q;
      x=p;y=q;
      reduce();
   }
   void print()const{cout<<x<<"/"<<y;}
};

class FVec{
   vector<Fraction>fv;
public:
   Fraction tol()const{
      Fraction ans=fv[0];
      for(int i=1;i<fv.size();i++){
         ans=ans.add(fv[i]);
      }
      return ans;
   }
   Fraction cross()const{
      Fraction ans=fv[0];
      for(int i=1;i<fv.size();i++){
         ans=ans.mul(fv[i]);
      }
      return ans;
   }
   Fraction avg()const{
      return tol().div(fv.size());
   }
   void read(){
      int n;cin>>n;
      for(int i=0;i<n;i++){Fraction f;f.read();fv.push_back(f);}
   }
   void print()const{
      tol().print();cout<<endl;
      cross().print();cout<<endl;
      avg().print();cout<<endl;
   }
};

int main(){
   FVec a;a.read();
   a.print();  //@ @guide uml:a
   return 0;
}
