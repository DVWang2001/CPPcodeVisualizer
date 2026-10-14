// UML 物件圖教案 CC-2601B：線段長度（組合：Section 有兩個 Fraction）
// （改寫自 CF 題目 CC-2601B：運算子多載、friend、繼承與 static 改成一般成員函式，才能在瀏覽器引擎逐步執行）
#include<iostream>
#include<cstdlib>
using namespace std;
class Fraction{public:
   int x,y;
   Fraction(int a=0,int b=0):x(a),y(b){}
   Fraction sub(Fraction b){return Fraction(abs(x*b.y-y*b.x),y*b.y);}
   void read(){char c;cin>>x>>c>>y;}
   void print(){cout<<x<<"/"<<y;}
};

int gcd(int a,int b){return b==0?a:gcd(b,a%b);}

class Section{public:
   Fraction a,b;
   Fraction len(){
      Fraction d=a.sub(b);
      int g=gcd(d.x,d.y);
      return Fraction(d.x/g,d.y/g);
   }
   void read(){a.read();b.read();}
   void print(){
      Fraction l=len();
      a.print();cout<<" ";b.print();cout<<" ";l.print();
   }
};

int main(){
   int n;cin>>n;
   while(n--){
      Section sec;sec.read();
      sec.print();cout<<endl;  //@ @guide uml:sec
   }
   return 0;
}
