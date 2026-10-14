// UML 物件圖教案 CC-26D02：複數向量（逐一輸入，output 成員函式輸出）
// （改寫自 CF 題目 CC-26D02：運算子多載、friend、繼承與 static 改成一般成員函式，才能在瀏覽器引擎逐步執行）
#include<iostream>
#include<cmath>
#include<vector>
using namespace std;
class Complex{public:
   double x,y;
   Complex(double a=0,double b=0):x(a),y(b){}
   Complex add(Complex p){return Complex(x+p.x,y+p.y);}
   Complex mul(Complex p){return Complex(x*p.x-y*p.y,y*p.x+x*p.y);}
   Complex div(double b){return Complex(x/b,y/b);}
   void read(){
      char c1,c2;
      cin>>x>>c1>>y>>c2;
      if(c1=='-')y*=-1;
   }
   void print(){
      if(y==0)cout<<x;
      else if(x==0)cout<<y<<"i";
      else if(y<0) cout<<x<<y<<"i";
      else cout<<x<<"+"<<y<<"i";
   }
};
class CVec{
   vector<Complex>cv;
public:
   void input(Complex c){
      cv.push_back(c);
   }
   void readOne(){
      Complex c;
      c.read();
      input(c);
   }
   void output(){
      cout<<"sum:";tol().print();cout<<endl;
      cout<<"Cross product:";cross().print();cout<<endl;
      cout<<"avg:";avg().print();cout<<endl;
   }
   Complex tol(){
      Complex ans=cv[0];
      for(int i=1;i<cv.size();i++){
         ans=ans.add(cv[i]);
      }
      return ans;
   }
   Complex cross(){
      Complex ans=cv[0];
      for(int i=1;i<cv.size();i++){
         ans=ans.mul(cv[i]);
      }
      return ans;
   }
   Complex avg(){
      return tol().div(cv.size());
   }
};
int main(){
   int n;cin>>n;
   CVec c;
   while(n--){
      c.readOne();
   }
   c.output();cout<<endl;  //@ @guide uml:c
   return 0;
}
